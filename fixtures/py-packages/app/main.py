from app.services import create_user

from .config import settings


def main():
    user = create_user("ada")
    print(settings.greeting, user)


if __name__ == "__main__":
    main()
