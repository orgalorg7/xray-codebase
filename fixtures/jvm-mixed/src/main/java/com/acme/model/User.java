package com.acme.model;

/** A person. */
public class User extends Entity {
  private String id;
  public User(String id) { super(); this.id = id; }
  public void save() { validate(); }
  @Override public String key() { return id; }
}
