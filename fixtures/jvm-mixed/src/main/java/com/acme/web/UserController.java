package com.acme.web;

import com.acme.model.*;
import com.acme.store.UserRepo;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {
  private final UserRepo repo;
  public UserController(UserRepo repo) { this.repo = repo; }
  @GetMapping("/{id}")
  public User get(@PathVariable String id) {
    User u = repo.load(id);
    var again = repo.load(id);
    again.save();
    u.key();
    return u;
  }
  @PostMapping
  public void create() { new User("x").save(); Users.audit(); }
}
