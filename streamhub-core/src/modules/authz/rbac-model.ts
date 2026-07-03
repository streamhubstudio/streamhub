/**
 * Casbin RBAC-with-domains model + the static role→permission policy.
 *
 * Domain = tenantId. The request subject is the caller's resolved role (from
 * `req.authCtx.role`); Casbin's default role manager treats `g(role, role, dom)`
 * as a match, so role-keyed policies fire directly. The model still carries the
 * `g` grouping so a future user→role binding per domain is purely additive.
 *
 * Policy domain is `*` (role capabilities are tenant-independent); the per-tenant
 * scoping (this app belongs to my tenant) is enforced separately in the guard.
 */
export const RBAC_MODEL = `
[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act

[role_definition]
g = _, _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub, r.dom) && (p.dom == "*" || p.dom == r.dom) && (p.obj == "*" || r.obj == p.obj) && (p.act == "*" || r.act == p.act)
`;

/**
 * Static policy rules: [subjectRole, domain, resource, action].
 * `superadmin` is intentionally NOT listed — it bypasses Casbin entirely in the
 * guard (so it can never be locked out by a bad policy).
 */
export function rbacPolicies(): string[][] {
  const rules: string[][] = [];

  // owner: full control within their tenant.
  rules.push(['owner', '*', '*', '*']);

  // viewer: read-only across every resource.
  rules.push(['viewer', '*', '*', 'read']);

  // editor: read everything + create/edit/operate apps & media, but NOT delete
  // the app itself nor touch tenant/token administration.
  const editor: [string, string][] = [
    ['app', 'create'],
    ['app', 'write'],
    ['config', 'read'],
    ['config', 'write'],
    ['s3', 'read'],
    ['s3', 'write'],
    ['stream', 'read'],
    ['stream', 'write'],
    ['stream', 'start'],
    ['stream', 'stop'],
    ['stream', 'delete'],
    ['recording', 'read'],
    ['recording', 'start'],
    ['recording', 'stop'],
    ['recording', 'write'],
    ['vod', 'read'],
    ['vod', 'write'],
    ['vod', 'delete'],
    ['broadcast', 'read'],
    ['broadcast', 'start'],
    ['broadcast', 'stop'],
    ['broadcast', 'write'],
    ['sample', 'read'],
    ['sample', 'write'],
    ['ingress', 'read'],
    ['ingress', 'create'],
    ['ingress', 'write'],
    ['ingress', 'delete'],
    ['usage', 'read'],
  ];
  for (const [obj, act] of editor) rules.push(['editor', '*', obj, act]);

  // `service` machine tokens are handled by the api_token bypass in the guard;
  // give them a broad allow anyway so an explicit enforce never trips them.
  rules.push(['service', '*', '*', '*']);

  return rules;
}
