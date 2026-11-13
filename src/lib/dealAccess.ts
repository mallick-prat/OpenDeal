import "server-only";
import { sql } from "./db";
import type { AppUser } from "./users";

/**
 * Per-deal write access: admins touch everything; the Contributor ('user') role
 * only deals they own (by owner name), co-own (deal_owners), or created in
 * the app. One rule, imported by server actions AND route handlers — the
 * attachments route used to check only "signed in", which let any member
 * upload onto any deal, including other members' private captures.
 */
export async function canTouchDeal(user: AppUser, gid: string): Promise<boolean> {
  if (user.role !== "user") return true;
  const ownerName = user.owner_name || user.name;
  const rows = await sql<{ gid: string }[]>`
    select gid from deals d
    where d.gid = ${gid}
      and (d.created_by = ${user.email}
           or (d.owner <> 'Unassigned' and d.owner = ${ownerName})
           or exists (
             select 1 from deal_owners o
             where o.deal_gid = d.gid and o.email = ${user.email}
           ))
  `;
  return rows.length > 0;
}
