class OxylabsMiddleware:
    def __init__(self, settings):
        self.user = settings.get("OXYLABS_USER", "")
        self.pw = settings.get("OXYLABS_PASS", "")

    @classmethod
    def from_crawler(cls, crawler):
        return cls(crawler.settings)

    def process_request(self, request, spider):
        proxy_uri = f"http://{self.user}:{self.pw}@unblock.oxylabs.io:60000"
        request.meta["proxy"] = proxy_uri
