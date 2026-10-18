from shop.db import connect


def test_connect():
    assert connect("x").url == "x"
