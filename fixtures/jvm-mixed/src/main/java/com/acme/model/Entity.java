package com.acme.model;

public abstract class Entity implements Keyed {
  public Entity() {}
  protected void validate() {}
  public abstract String key();
}
