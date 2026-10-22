using Acme.Data;
using Xunit;

namespace Acme.Tests;

public class UserRepoTests
{
    [Fact]
    public void Loads() { new UserRepo().Load("a"); }
}
