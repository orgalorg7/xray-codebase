namespace Acme.Models;

/// <summary>A person.</summary>
public class User : Entity, IKeyed
{
    public string Id { get; set; }
    public User(string id) : base() { Id = id; }
    public void Save() { Validate(); }
    public override string Key() => Id;
}
