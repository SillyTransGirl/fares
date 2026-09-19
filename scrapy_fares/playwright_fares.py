"""Use Playwright (real Chrome) to call bahn.de API through SOCKS5 proxy."""
import json
import sys
import asyncio


async def fetch_fares(from_eva, to_eva, date_str, time_str="10:00:00", age=None, bahncard=None):
    from playwright.async_api import async_playwright

    typ = "ERWACHSENER"
    if age is not None:
        age = int(age)
        if age < 5: typ = "KLEINKIND"
        elif age < 15: typ = "KIND"
        elif age < 27: typ = "JUGENDLICH"
        elif age >= 65: typ = "SENIOR"

    erm = [{"art": "KEINE_ERMAESSIGUNG", "klasse": "KLASSENLOS"}]
    if bahncard:
        bc = bahncard.upper().replace("BAHN_CARD_", "").replace("BC", "")
        if bc in ("25_1", "251"): erm = [{"art": "BAHNCARD25", "klasse": "KLASSE_2"}]
        elif bc in ("25_2", "252"): erm = [{"art": "BAHNCARD25", "klasse": "KLASSE_1"}]
        elif bc in ("50_1", "501"): erm = [{"art": "BAHNCARD50", "klasse": "KLASSE_2"}]
        elif bc in ("50_2", "502"): erm = [{"art": "BAHNCARD50", "klasse": "KLASSE_1"}]

    traveller = [{"typ": typ, "ermaessigungen": erm, "anzahl": 1, "alter": [age] if age is not None else []}]

    payload = {
        "abfahrtsHalt": f"A=1@L={from_eva}@",
        "anfrageZeitpunkt": f"{date_str}T{time_str}",
        "ankunftsHalt": f"A=1@L={to_eva}@",
        "ankunftSuche": "ABFAHRT",
        "klasse": "KLASSE_2",
        "produktgattungen": ["ICE", "EC_IC", "IR", "REGIONAL", "SBAHN", "BUS", "SCHIFF", "UBAHN", "TRAM", "ANRUFPFLICHTIG"],
        "reisende": traveller,
        "schnelleVerbindungen": True,
        "deutschlandTicketVorhanden": False,
    }

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            proxy={"server": "socks5://100.127.147.36:1080"},
        )
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            locale="de-DE",
        )

        page = await context.new_page()

        # First visit bahn.de to get cookies (Akamai bm_sz)
        try:
            await page.goto("https://www.bahn.de", wait_until="domcontentloaded", timeout=20000)
            await page.wait_for_timeout(2000)
        except Exception:
            pass

        # Now make the API call using the browser's context (same cookies, TLS fingerprint)
        try:
            response = await page.evaluate("""
                async (payload) => {
                    const r = await fetch('https://www.bahn.de/web/api/angebote/fahrplan', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json; charset=UTF-8',
                            'Accept': 'application/json',
                        },
                        body: JSON.stringify(payload),
                    });
                    return { status: r.status, body: await r.text() };
                }
            """, payload)

            if response["status"] == 200:
                data = json.loads(response["body"])
                verbindungen = data.get("verbindungen", [])
                return {"verbindungen": verbindungen[:8]}
            else:
                return {"error": f"HTTP {response['status']}", "body": response["body"][:200]}

        except Exception as e:
            return {"error": f"fetch failed: {str(e)[:200]}"}
        finally:
            await browser.close()


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--from-eva", required=True)
    parser.add_argument("--to-eva", required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--time", default="10:00:00")
    parser.add_argument("--age", default=None)
    parser.add_argument("--bahncard", default=None)
    args = parser.parse_args()

    result = asyncio.run(fetch_fares(
        args.from_eva, args.to_eva, args.date, args.time,
        args.age, args.bahncard,
    ))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
