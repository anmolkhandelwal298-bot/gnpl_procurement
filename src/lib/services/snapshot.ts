import { withUser } from "../db";
import type { SessionUser } from "../auth/session";
import { getAdminAuctionView, getVendorAuctionView } from "./auctions";
import { q1 } from "../db";

/**
 * The single place that decides what a viewer may see of a live auction. Used by the SSE stream and the polling fallback.
 *  - staff:  full ranking, prices, events
 *  - vendor: own price / own rank / own history only (from SECURITY DEFINER functions that cannot return anything else)
 */
export async function buildSnapshot(user: SessionUser, rfqId: string) {
  return withUser(user.id, async (db) => {
    const rfq = await q1<any>(db, "select id, rfq_number, status, auction_start_at, auction_end_at from rfqs where id=$1", [rfqId]);
    if (!rfq) return null;                                   // RLS: vendors get null for RFQs they were not invited to
    if (user.role === "vendor") {
      const view = await getVendorAuctionView(db, rfqId);
      return { kind: "vendor" as const, rfq: { id: rfq.id, status: rfq.status }, auction: view, serverTime: view?.server_time ?? new Date().toISOString() };
    }
    const view = await getAdminAuctionView(db, rfqId);
    return { kind: "staff" as const, rfq, ...view, serverTime: view.serverTime };
  });
}
