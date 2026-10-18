import pytest
from tests.load_testdata import load_json_testcases

from quixbugs.lis import lis


testdata = load_json_testcases(lis.__name__)


@pytest.mark.parametrize("input_data,expected", testdata)
def test_lis(input_data, expected):
    assert lis(*input_data) == expected
