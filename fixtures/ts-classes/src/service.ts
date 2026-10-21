import { AdminRepo } from "./admin-repo.js";
import type { Repository, User } from "./repository.js";

export function lookup(repo: Repository<User>, id: string): User | undefined {
  return repo.find(id);
}

export function adminLookup(id: string): User | undefined {
  return lookup(new AdminRepo(), id);
}
