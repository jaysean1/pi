import { UserCache, type UserSnapshot } from "./user-cache.ts";

export interface UserRepository {
  find(id: string): Promise<UserSnapshot | undefined>;
  save(user: UserSnapshot): Promise<void>;
}

export class UserService {
  private readonly repository: UserRepository;
  private readonly cache: UserCache;

  constructor(repository: UserRepository, cache: UserCache) {
    this.repository = repository;
    this.cache = cache;
  }

  async getUser(id: string): Promise<UserSnapshot | undefined> {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const user = await this.repository.find(id);
    if (user) this.cache.set(user);
    return user;
  }

  async updateName(id: string, name: string): Promise<void> {
    await this.repository.save({ id, name });
  }
}
