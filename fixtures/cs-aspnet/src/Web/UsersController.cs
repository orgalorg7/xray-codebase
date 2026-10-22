using Acme.Data;
using Acme.Models;
using Microsoft.AspNetCore.Mvc;

namespace Acme.Web;

[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase
{
    private readonly UserRepo _repo;
    public UsersController(UserRepo repo) { _repo = repo; }

    [HttpGet("{id}")]
    public User Get(string id)
    {
        var u = _repo.Load(id);
        u.Save();
        User other = new User(id);
        this.Audit(other);
        return u;
    }

    [HttpPost]
    public void Create() { new User("x").Save(); }

    private void Audit(User u) { u.Key(); }
}
