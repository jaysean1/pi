import assert from "node:assert/strict";
import test from "node:test";

import { UserCache, type UserSnapshot } from "../src/user-cache.ts";
import { UserService, type UserRepository } from "../src/user-service.ts";

class MemoryRepository implements UserRepository {
  readonly users = new Map<string, UserSnapshot>();
  findCalls = 0;

  async find(id: string): Promise<UserSnapshot | undefined> {
    this.findCalls += 1;
    const user = this.users.get(id);
    return user ? { ...user } : undefined;
  }

  async save(user: UserSnapshot): Promise<void> {
    this.users.set(user.id, { ...user });
  }
}

test("getUser caches repository reads", async () => {
  const repository = new MemoryRepository();
  repository.users.set("u1", { id: "u1", name: "Ada" });
  const service = new UserService(repository, new UserCache(60_000));

  assert.equal((await service.getUser("u1"))?.name, "Ada");
  assert.equal((await service.getUser("u1"))?.name, "Ada");
  assert.equal(repository.findCalls, 1);
});
