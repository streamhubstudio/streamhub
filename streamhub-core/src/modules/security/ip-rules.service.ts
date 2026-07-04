import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { DbService } from '../../shared/db/db.service';
import {
  ipInCidr,
  isPrivateOrLoopbackIp,
  parseCidr,
  parseIp,
  type ParsedCidr,
} from './ip-cidr.util';

/** A persisted allow/block rule as surfaced by the admin API. */
export interface IpRule {
  id: number;
  cidr: string;
  action: 'allow' | 'block';
  note: string | null;
  createdAt: string;
  createdBy: string | null;
}

/** Raw row shape of ip_rules (snake_case from SQLite). */
interface IpRuleRow {
  id: number;
  cidr: string;
  action: 'allow' | 'block';
  note: string | null;
  created_at: string;
  created_by: string | null;
}

/** Outcome of matching an IP against the EXPLICIT rules only. */
export type RuleMatch = 'allow' | 'block' | 'none';

/**
 * Global IP allow/blocklist (network-security feature).
 *
 * Rules live in the GLOBAL DB table `ip_rules` (seeded idempotently on boot,
 * mirroring the other control-plane tables — sessions/magic_tokens) and are
 * COMPILED into memory (BigInt network + prefix) so the per-request match in
 * the middleware is a cheap array scan with zero DB access. Any mutation
 * through this service reloads the compiled cache immediately.
 *
 * Precedence is implemented in {@link evaluate}: explicit allow > explicit
 * block. Loopback/RFC1918 are NOT consulted here — the middleware short-
 * circuits them before rules run (the lock-out guarantee).
 */
@Injectable()
export class IpRulesService implements OnModuleInit {
  private readonly logger = new Logger(IpRulesService.name);

  /** Compiled rules cache (refreshed on every mutation). */
  private compiled: Array<{ rule: IpRule; parsed: ParsedCidr }> = [];

  constructor(private readonly db: DbService) {}

  onModuleInit(): void {
    try {
      this.ensureSchema();
      this.reload();
    } catch (err) {
      this.logger.error(
        `ip_rules bootstrap failed (continuing): ${(err as Error).message}`,
      );
    }
  }

  private ensureSchema(): void {
    this.db.global().exec(
      `CREATE TABLE IF NOT EXISTS ip_rules (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         cidr TEXT NOT NULL,
         action TEXT NOT NULL CHECK (action IN ('allow', 'block')),
         note TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         created_by TEXT
       );
       CREATE INDEX IF NOT EXISTS idx_ip_rules_action ON ip_rules(action);`,
    );
  }

  /** Re-read + re-compile every rule from the DB (drops unparseable rows). */
  reload(): void {
    const rows = this.db
      .global()
      .prepare(
        `SELECT id, cidr, action, note, created_at, created_by
           FROM ip_rules ORDER BY id ASC`,
      )
      .all() as IpRuleRow[];
    const compiled: Array<{ rule: IpRule; parsed: ParsedCidr }> = [];
    for (const row of rows) {
      const parsed = parseCidr(row.cidr);
      if (!parsed) {
        this.logger.warn(`ip_rules row ${row.id} has invalid cidr, skipping`);
        continue;
      }
      compiled.push({ rule: this.toView(row), parsed });
    }
    this.compiled = compiled;
  }

  // ---------------------------------------------------------------------------
  // Matching (hot path — in-memory only)
  // ---------------------------------------------------------------------------

  /**
   * Match an IP against the explicit rules. Precedence: any matching `allow`
   * rule wins over any matching `block` rule; no match → 'none'. Unparseable
   * IPs never match (the middleware treats that as default).
   */
  evaluate(ip: string): RuleMatch {
    const parsed = parseIp(ip);
    if (!parsed) return 'none';
    let match: RuleMatch = 'none';
    for (const { rule, parsed: cidr } of this.compiled) {
      if (!ipInCidr(parsed, cidr)) continue;
      if (rule.action === 'allow') return 'allow';
      match = 'block';
    }
    return match;
  }

  /** True when the IP matches an explicit allow rule (never auto-banned). */
  isAllowlisted(ip: string): boolean {
    return this.evaluate(ip) === 'allow';
  }

  // ---------------------------------------------------------------------------
  // Admin CRUD
  // ---------------------------------------------------------------------------

  list(): IpRule[] {
    const rows = this.db
      .global()
      .prepare(
        `SELECT id, cidr, action, note, created_at, created_by
           FROM ip_rules ORDER BY id DESC`,
      )
      .all() as IpRuleRow[];
    return rows.map((r) => this.toView(r));
  }

  add(input: {
    cidr: string;
    action: 'allow' | 'block';
    note?: string | null;
    createdBy?: string | null;
  }): IpRule {
    const parsed = parseCidr(input.cidr);
    if (!parsed) {
      throw new BadRequestException(
        'invalid CIDR — expected an IPv4/IPv6 address or a.b.c.d/nn form',
      );
    }
    // Store the normalised `<ip>/<prefix>` so the list is unambiguous.
    const cidr = parsed.cidr;
    const dup = this.db
      .global()
      .prepare(`SELECT id FROM ip_rules WHERE cidr = ? AND action = ? LIMIT 1`)
      .get(cidr, input.action) as { id: number } | undefined;
    if (dup) {
      throw new BadRequestException(`rule already exists (id ${dup.id})`);
    }
    if (input.action === 'block' && isPrivateOrLoopbackIp(cidr.split('/')[0])) {
      // Accepted but pointless — warn the operator instead of silently no-oping.
      this.logger.warn(
        `block rule ${cidr} covers a private/loopback range — those are always permitted`,
      );
    }
    const res = this.db
      .global()
      .prepare(
        `INSERT INTO ip_rules (cidr, action, note, created_by)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        cidr,
        input.action,
        input.note?.trim() || null,
        input.createdBy ?? null,
      );
    this.reload();
    const row = this.db
      .global()
      .prepare(
        `SELECT id, cidr, action, note, created_at, created_by
           FROM ip_rules WHERE id = ?`,
      )
      .get(Number(res.lastInsertRowid)) as IpRuleRow;
    this.logger.log(`ip rule added: ${input.action} ${cidr}`);
    return this.toView(row);
  }

  remove(id: number): void {
    const res = this.db
      .global()
      .prepare(`DELETE FROM ip_rules WHERE id = ?`)
      .run(id);
    if (res.changes === 0) {
      throw new NotFoundException(`ip rule ${id} not found`);
    }
    this.reload();
    this.logger.log(`ip rule ${id} removed`);
  }

  /** Rule counts for GET /security/status. */
  counts(): { total: number; allow: number; block: number } {
    let allow = 0;
    let block = 0;
    for (const { rule } of this.compiled) {
      if (rule.action === 'allow') allow++;
      else block++;
    }
    return { total: this.compiled.length, allow, block };
  }

  private toView(r: IpRuleRow): IpRule {
    return {
      id: r.id,
      cidr: r.cidr,
      action: r.action,
      note: r.note,
      createdAt: r.created_at,
      createdBy: r.created_by,
    };
  }
}
