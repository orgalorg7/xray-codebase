from ..models import User


def create_user(name):
    user = User(name)
    user.save()
    return user
