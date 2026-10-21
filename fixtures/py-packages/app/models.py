class User:
    def __init__(self, name):
        self.name = name

    def save(self):
        return _write(self.name)


def _write(value):
    return len(value)
