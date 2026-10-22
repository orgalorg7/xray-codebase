import type { Annotation } from "./model.js";

/** Joins route segments: `api/[controller]` + `{id}` → `/api/[controller]/{id}`. */
export function joinRoute(...parts: (string | undefined)[]): string {
  const path = parts
    .filter((p): p is string => p !== undefined && p !== "")
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return `/${path}`;
}

const VERB_ANNOTATIONS: Record<string, string> = {
  // Spring
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
  // ASP.NET
  HttpGet: "GET",
  HttpPost: "POST",
  HttpPut: "PUT",
  HttpDelete: "DELETE",
  HttpPatch: "PATCH",
  // JAX-RS (with @Path)
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  DELETE: "DELETE",
  PATCH: "PATCH",
};

const pathOf = (a: Annotation | undefined): string | undefined =>
  a
    ? (a.strings[0] ?? a.named.value?.[0] ?? a.named.path?.[0] ?? a.named.Template?.[0])
    : undefined;

const find = (annotations: Annotation[], ...names: string[]) =>
  annotations.find((a) => names.includes(a.name));

/**
 * The HTTP routes of a controller method from Spring, JAX-RS or ASP.NET annotations on the
 * method and its class. `[controller]` and `[action]` take the class and method names.
 */
export function annotatedRoutes(
  classAnnotations: Annotation[],
  methodAnnotations: Annotation[],
  className: string,
  methodName: string,
): { method: string; path: string; framework: string }[] {
  const prefix = pathOf(find(classAnnotations, "RequestMapping", "Path", "Route"));
  const routes: { method: string; path: string; framework: string }[] = [];
  const route = methodAnnotations.find((a) => a.name === "Route" || a.name === "Path");
  for (const annotation of methodAnnotations) {
    let method = VERB_ANNOTATIONS[annotation.name];
    let framework = /Mapping$/.test(annotation.name)
      ? "spring"
      : /^Http/.test(annotation.name)
        ? "aspnet"
        : "jax-rs";
    if (annotation.name === "RequestMapping") {
      method = annotation.named.method?.[0]?.split(".").pop()?.toUpperCase() ?? "ANY";
      framework = "spring";
    }
    if (!method) continue;
    const sub = pathOf(annotation) ?? pathOf(route);
    if (framework === "jax-rs" && prefix === undefined && sub === undefined) continue;
    const controller = className.replace(/Controller$/, "");
    const path = joinRoute(prefix, sub)
      .replaceAll("[controller]", controller)
      .replaceAll("[action]", methodName);
    routes.push({ method, path, framework });
  }
  return routes;
}

/** Test annotations of JUnit, kotlin.test, xUnit, NUnit and MSTest. */
export const TEST_ANNOTATIONS = new Set([
  "Test",
  "ParameterizedTest",
  "RepeatedTest",
  "TestFactory",
  "Fact",
  "Theory",
  "TestMethod",
  "TestCase",
  "DataTestMethod",
]);
