package com.acme.store;

import org.junit.jupiter.api.Test;

class UserRepoTest {
  @Test
  void loads() { new UserRepo().load("a"); }
}
