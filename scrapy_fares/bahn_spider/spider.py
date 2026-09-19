import scrapy
import json
import sys
import os
from scrapy import signals


class BahnFareSpider(scrapy.Spider):
    name = "bahn_fare"

    custom_settings = {
        "DOWNLOAD_TIMEOUT": 60,
        "RETRY_TIMES": 2,
        "LOG_LEVEL": "ERROR",
        "HTTPERROR_ALLOW_ALL": True,
        "DOWNLOADER_MIDDLEWARES": {
            "bahn_spider.middleware.OxylabsMiddleware": 350,
        },
        "REQUEST_FINGERPRINTER_IMPLEMENTATION": "2.7",
        "TWISTED_REACTOR": "twisted.internet.asyncioreactor.AsyncioSelectorReactor",
    }

    def __init__(self, from_eva=None, to_eva=None, date_str=None, time_str="10:00:00",
                 sparpreis="false", age=None, bahncard=None, **kwargs):
        super().__init__(**kwargs)
        self.from_eva = from_eva
        self.to_eva = to_eva
        self.date_str = date_str
        self.time_str = time_str
        self.sparpreis = sparpreis.lower() == "true"
        self.age = int(age) if age else None
        self.bahncard = bahncard
        self._collected = None

    def start_requests(self):
        traveller = self._make_traveller()
        payload = {
            "abfahrtsHalt": f"A=1@L={self.from_eva}@",
            "anfrageZeitpunkt": f"{self.date_str}T{self.time_str}",
            "ankunftsHalt": f"A=1@L={self.to_eva}@",
            "ankunftSuche": "ABFAHRT",
            "klasse": "KLASSE_2",
            "produktgattungen": ["ICE", "EC_IC", "IR", "REGIONAL", "SBAHN", "BUS", "SCHIFF", "UBAHN", "TRAM", "ANRUFPFLICHTIG"],
            "reisende": traveller,
            "schnelleVerbindungen": True,
            "deutschlandTicketVorhanden": False,
        }

        yield scrapy.Request(
            url="https://www.bahn.de/web/api/angebote/fahrplan",
            method="POST",
            body=json.dumps(payload),
            headers={
                "Content-Type": "application/json; charset=UTF-8",
                "Accept": "application/json",
                "Origin": "https://www.bahn.de",
                "Referer": "https://www.bahn.de/buchung/fahrplan/suche",
                "X-Oxylabs-Geo-Location": "Germany",
            },
            callback=self.parse_fahrplan,
            errback=self._errback,
            dont_filter=True,
            meta={"traveller": traveller},
        )

    def parse_fahrplan(self, response):
        try:
            data = json.loads(response.text)
        except Exception:
            self._set({"error": "fahrplan: invalid JSON"})
            return

        if data.get("status") == "ERROR":
            self._set({"error": f"fahrplan: {data.get('code', 'unknown')}"})
            return

        verbindungen = data.get("verbindungen", [])
        if not verbindungen:
            self._set({"empty": True})
            return

        no_price = [v for v in verbindungen if not v.get("angebotsPreis", {}).get("betrag") and v.get("ctxRecon")][:3]

        if not no_price:
            self._set({"verbindungen": verbindungen[:8]})
            return

        for v in no_price:
            recon_payload = {
                "klasse": "KLASSE_2",
                "reisende": response.meta["traveller"],
                "ctxRecon": v["ctxRecon"],
                "deutschlandTicketVorhanden": False,
            }
            yield scrapy.Request(
                url="https://www.bahn.de/web/api/angebote/recon",
                method="POST",
                body=json.dumps(recon_payload),
                headers={
                    "Content-Type": "application/json; charset=UTF-8",
                    "Accept": "application/json",
                    "Origin": "https://www.bahn.de",
                    "Referer": "https://www.bahn.de/buchung/fahrplan/suche",
                    "X-Oxylabs-Geo-Location": "Germany",
                },
                callback=self.parse_recon,
                errback=self._errback,
                dont_filter=True,
                meta={"verbindungen": verbindungen, "ctxRecon": v["ctxRecon"], "remaining": len(no_price)},
            )

    def parse_recon(self, response):
        verbindungen = response.meta["verbindungen"]
        ctx = response.meta["ctxRecon"]
        remaining = response.meta.get("remaining", 1) - 1

        try:
            data = json.loads(response.text)
            rv = (data.get("verbindungen") or [None])[0]
            if rv:
                for v in verbindungen:
                    if v.get("ctxRecon") == ctx:
                        if rv.get("angebotsPreis", {}).get("betrag") and not v.get("angebotsPreis", {}).get("betrag"):
                            v["angebotsPreis"] = rv["angebotsPreis"]
                        if rv.get("reiseAngebote"):
                            v["reiseAngebote"] = rv["reiseAngebote"]
                        break
        except Exception:
            pass

        if remaining <= 0:
            self._set({"verbindungen": verbindungen[:8]})

    def _set(self, result):
        if self._collected is None:
            self._collected = result

    def _errback(self, failure):
        self._set({"error": str(failure)[:200]})

    def _make_traveller(self):
        typ = "ERWACHSENER"
        if self.age is not None:
            if self.age < 5: typ = "KLEINKIND"
            elif self.age < 15: typ = "KIND"
            elif self.age < 27: typ = "JUGENDLICH"
            elif self.age >= 65: typ = "SENIOR"

        erm = [{"art": "KEINE_ERMAESSIGUNG", "klasse": "KLASSENLOS"}]
        if self.bahncard:
            bc = self.bahncard.upper().replace("BAHN_CARD_", "").replace("BC", "")
            if bc in ("25_1", "251"): erm = [{"art": "BAHNCARD25", "klasse": "KLASSE_2"}]
            elif bc in ("25_2", "252"): erm = [{"art": "BAHNCARD25", "klasse": "KLASSE_1"}]
            elif bc in ("50_1", "501"): erm = [{"art": "BAHNCARD50", "klasse": "KLASSE_2"}]
            elif bc in ("50_2", "502"): erm = [{"art": "BAHNCARD50", "klasse": "KLASSE_1"}]

        return [{"typ": typ, "ermaessigungen": erm, "anzahl": 1, "alter": [self.age] if self.age is not None else []}]


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--from-eva", required=True)
    parser.add_argument("--to-eva", required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--time", default="10:00:00")
    parser.add_argument("--sparpreis", default="false")
    parser.add_argument("--age", default=None)
    parser.add_argument("--bahncard", default=None)
    args = parser.parse_args()

    from scrapy.crawler import CrawlerProcess
    from scrapy.utils.project import get_project_settings

    settings = get_project_settings()
    process = CrawlerProcess(settings)

    results = []

    class ResultSpider(BahnFareSpider):
        def _set(self, result):
            results.append(result)

    process.crawl(
        ResultSpider,
        from_eva=args.from_eva,
        to_eva=args.to_eva,
        date_str=args.date,
        time_str=args.time,
        sparpreis=args.sparpreis,
        age=args.age,
        bahncard=args.bahncard,
    )
    process.start()

    if results:
        print(json.dumps(results[0]))
    else:
        print(json.dumps({"error": "no results"}))


if __name__ == "__main__":
    main()
