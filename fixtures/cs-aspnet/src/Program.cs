using Acme.Data;

var app = WebApplication.Create(args);
app.MapGet("/health", Health.Check);
app.Run();

static class Health { public static string Check() => "ok"; }
