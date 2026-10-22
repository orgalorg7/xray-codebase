using Acme.Models;
using System.Collections.Generic;

namespace Acme.Data;

public class UserRepo
{
    public User Load(string id) => new User(Strings.Trim(id));
}

public static class Strings { public static string Trim(string s) => s.Trim(); }
