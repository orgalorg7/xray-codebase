export interface Repository<T> {
  find(id: string): T | undefined;
}

export type User = { id: string; name: string };
