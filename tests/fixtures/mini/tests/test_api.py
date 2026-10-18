from shop.api import get_user, health


def test_get_user():
    assert get_user({"id": 1})["key"] == 1


def test_health():
    assert health()["ok"]
