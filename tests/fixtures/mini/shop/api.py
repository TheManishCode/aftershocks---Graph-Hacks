from shop import service


def get_user(request):
    return service.load_user(request["id"])


def health():
    return {"ok": True}


def _unused_helper():
    return 42
