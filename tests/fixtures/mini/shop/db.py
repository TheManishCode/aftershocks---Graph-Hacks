"""Storage layer: the thing everything else leans on."""


class Store:
    def __init__(self, url):
        self.url = url

    def get(self, key):
        return {"key": key, "url": self.url}


def connect(url):
    return Store(url)
