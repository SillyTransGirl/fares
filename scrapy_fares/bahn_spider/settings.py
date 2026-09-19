import os

BOT_NAME = "bahn_spider"
SPIDER_MODULES = ["bahn_spider.spider"]
NEWSPIDER_MODULE = "bahn_spider"

OXYLABS_USER = os.environ.get("OXYLABS_USER", "")
OXYLABS_PASS = os.environ.get("OXYLABS_PASS", "")

DOWNLOAD_TIMEOUT = 60
RETRY_TIMES = 2
LOG_LEVEL = "WARNING"
HTTPERROR_ALLOW_ALL = True

DOWNLOADER_MIDDLEWARES = {
    "bahn_spider.middleware.OxylabsMiddleware": 350,
}

REQUEST_FINGERPRINTER_IMPLEMENTATION = "2.7"
TWISTED_REACTOR = "twisted.internet.asyncioreactor.AsyncioSelectorReactor"
FEED_EXPORT_ENCODING = "utf-8"
