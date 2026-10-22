package com.acme.store;

import com.acme.model.User;
import java.util.List;
import static com.acme.store.Strings.trim;

public class UserRepo {
  public User load(String id) { return new User(trim(id)); }
  public List<User> all() { return List.of(); }
}
