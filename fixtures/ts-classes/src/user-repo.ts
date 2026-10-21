import type { Repository, User } from "./repository.js";

export class UserRepo implements Repository<User> {
  protected users = new Map<string, User>();

  find(id: string): User | undefined {
    return this.users.get(id);
  }

  add(user: User): void {
    this.users.set(user.id, user);
  }
}
