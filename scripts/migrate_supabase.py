#!/usr/bin/env python3
"""Move the kit's rows from one Supabase project to another.

Moving the database is two things: the schema (paste supabase/schema.sql
into the new project's SQL editor once) and the rows. This script does
the rows. It reads destinations, scenarios, messages and runs from the
old project — in that order, so every foreign key already has its parent
when it lands — and upserts them into the new one with ids and
timestamps intact: every pin, debrief, scenario version, feedback trail
and recorded run carries over, and re-running is safe (upsert on id).

  # copy everything into the kit's project (the default target, the
  # same one config.js points at):
  python3 scripts/migrate_supabase.py --from-url https://OLD.supabase.co --from-key OLD_ANON_KEY

  # read-only rehearsal — counts on both sides, no writes:
  python3 scripts/migrate_supabase.py --from-url ... --from-key ... --dry-run

  # any other target:
  python3 scripts/migrate_supabase.py --from-url ... --from-key ... \\
      --to-url https://NEW.supabase.co --to-key NEW_ANON_KEY

Both projects need the pilot policies from schema.sql (the anon key reads
and writes). A column the old project has that the new schema lacks
stops the copy with the PostgREST message naming it — add the column on
the new side (or drop it from the old rows) and re-run. Standard library
only, like the rest of the kit.
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

# The kit's Supabase project — the same pair config.js carries. The
# publishable (anon) key is public by design; RLS is the protection.
DEFAULT_URL = 'https://lgyycoxsqrnhawzlqxlq.supabase.co'
DEFAULT_KEY = 'sb_publishable_UhActVk58ukgC6On1z9yuw_IbsMeWJf'

# Parents before children: messages and scenarios reference destinations,
# runs reference scenarios (runs.destination_id is deliberately not a FK).
TABLES = ['destinations', 'scenarios', 'messages', 'runs']
PAGE = 1000  # PostgREST's default max-rows on Supabase


class Project:
    def __init__(self, url, key):
        self.url = url.rstrip('/')
        self.key = key

    def request(self, method, path, body=None, prefer=None, extra=None):
        headers = {'apikey': self.key, 'Authorization': 'Bearer ' + self.key,
                   'Content-Type': 'application/json'}
        if prefer:
            headers['Prefer'] = prefer
        headers.update(extra or {})
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read()
                # r.headers looks names up case-insensitively (the gateway lowercases them)
                return r.status, r.headers, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors='replace')[:400]
            raise SystemExit(f'{method} {self.url}{path} -> HTTP {e.code}: {detail}')
        except urllib.error.URLError as e:
            raise SystemExit(f'{method} {self.url}{path} -> {e.reason}')

    def has_table(self, table):
        """False when PostgREST cannot see the table — schema.sql not run yet."""
        req = urllib.request.Request(
            f'{self.url}/rest/v1/{table}?select=id&limit=1',
            headers={'apikey': self.key, 'Authorization': 'Bearer ' + self.key})
        try:
            with urllib.request.urlopen(req, timeout=60):
                return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False
            raise SystemExit(f'GET {self.url}/rest/v1/{table} -> HTTP {e.code}: '
                             f'{e.read().decode(errors="replace")[:400]}')
        except urllib.error.URLError as e:
            raise SystemExit(f'GET {self.url}/rest/v1/{table} -> {e.reason}')

    def count(self, table):
        _, headers, _ = self.request('GET', f'/rest/v1/{table}?select=id&limit=1',
                                     prefer='count=exact')
        # Content-Range is "0-0/123", or "*/0" for an empty table
        return int(headers.get('Content-Range', '*/0').rsplit('/', 1)[1])

    def read_all(self, table):
        # page until a page comes back empty — a project whose max-rows is
        # set below PAGE would otherwise stop after its first, shorter page
        rows = []
        while True:
            _, _, page = self.request(
                'GET', f'/rest/v1/{table}?select=*&order=created_at.asc,id.asc'
                       f'&limit={PAGE}&offset={len(rows)}')
            if not page:
                return rows
            rows.extend(page)

    def upsert(self, table, rows, chunk):
        for i in range(0, len(rows), chunk):
            self.request('POST', f'/rest/v1/{table}?on_conflict=id', body=rows[i:i + chunk],
                         prefer='resolution=merge-duplicates,return=minimal')


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--from-url', required=True, help='the project to copy FROM')
    ap.add_argument('--from-key', required=True, help='its publishable / anon key')
    ap.add_argument('--to-url', default=DEFAULT_URL,
                    help="the project to copy INTO (default: the kit's, as in config.js)")
    ap.add_argument('--to-key', default=DEFAULT_KEY,
                    help="its publishable / anon key (default: the kit's)")
    ap.add_argument('--dry-run', action='store_true', help='read and count only — write nothing')
    ap.add_argument('--chunk', type=int, default=100, metavar='N',
                    help='rows per insert request (default 100; lower it if runs carry long fix streams)')
    args = ap.parse_args()

    src, dst = Project(args.from_url, args.from_key), Project(args.to_url, args.to_key)
    if src.url == dst.url:
        sys.exit('source and target are the same project — nothing to move')

    missing = [t for t in TABLES if not dst.has_table(t)]
    if missing:
        sys.exit(f'{dst.url} has no {", ".join(missing)} table(s) — run supabase/schema.sql '
                 'in its SQL editor once, then re-run this')

    print(f'{src.url}  ->  {dst.url}' + ('  (dry run)' if args.dry_run else ''))
    for table in TABLES:
        rows = src.read_all(table)
        before = dst.count(table)
        if args.dry_run or not rows:
            print(f'  {table:13s} {len(rows):6d} row(s) to copy   target holds {before}')
            continue
        dst.upsert(table, rows, max(1, args.chunk))
        after = dst.count(table)
        print(f'  {table:13s} {len(rows):6d} row(s) copied    target holds {after} (was {before})')
        if after < len(rows):
            sys.exit(f'{table}: the target holds fewer rows than were copied — '
                     'check its RLS policies (schema.sql) and re-run')
    print('done' if not args.dry_run else 'nothing written')


if __name__ == '__main__':
    main()
