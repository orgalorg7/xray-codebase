import type { User } from "./repository.js";
import { UserRepo } from "./user-repo.js";

export class AdminRepo extends UserRepo {
  override find(id: string): User | undefined {
    const user = super.find(id);
    return user && this.isAdmin(user) ? user : undefined;
  }

  private isAdmin(user: User): boolean {
    return user.name.startsWith("admin");
  }
}
