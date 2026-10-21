from shapes import Circle, Square


def build():
    return [Circle(2), Square.unit()]


def report():
    for shape in build():
        print(shape.describe())
