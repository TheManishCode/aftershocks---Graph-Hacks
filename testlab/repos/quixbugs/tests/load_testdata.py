import json
from pathlib import Path


def load_json_testcases(algorithm):
    path = Path(__file__).parent.parent / "testcases" / f"{algorithm}.json"
    with open(path) as data_file:
        return [json.loads(line) for line in data_file]
