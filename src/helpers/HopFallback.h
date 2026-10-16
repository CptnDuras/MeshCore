#pragma once

#include <Packet.h>

namespace mesh {

/**
 * \brief  Can a unicast packet that a repeater was relaying be flooded instead, when the next hop on its path does not answer?
 *
 * A client that cached a path keeps sending DIRECT along it. If a repeater on that path has died (or been replaced and so
 * has a new id), the repeater before it hears nothing from the next hop and, after its retries, used to drop the packet:
 * the message was lost until the client gave up on its cache. Flooding from that repeater instead gets the message through
 * whatever the client's cache says, and the flood makes the far end answer with a PATH return, which refreshes the client's
 * stale path.
 *
 * Only for packets that carry end-to-end encrypted payloads addressed to a node: not TRACE (its path is the thing being measured),
 * MULTIPART, CONTROL, ADVERT, group messages (never sent DIRECT), or ROUTED envelopes (those fall back by their sender flooding the inner packet).
 */
inline bool isHopFallbackType(uint8_t payload_type) {
  switch (payload_type) {
    case PAYLOAD_TYPE_REQ:
    case PAYLOAD_TYPE_RESPONSE:
    case PAYLOAD_TYPE_TXT_MSG:
    case PAYLOAD_TYPE_ACK:
    case PAYLOAD_TYPE_PATH:
    case PAYLOAD_TYPE_ANON_REQ:
      return true;
    default:
      return false;
  }
}

/**
 * \brief  Rewrite a DIRECT packet, as this repeater just sent it on, into a flood that starts here.
 *
 * The path becomes this repeater's own hash alone (one hop, same hash size the client chose), exactly what a flood this
 * repeater had relayed would carry. That matters: the far end reports the path a flood took back to the sender, which stores
 * it as its route. Without our hash the path would start at the next repeater after us, which the sender may not be able to reach.
 * A packet sent with transport codes keeps them, so a scoped message stays in its scope.
 *
 * \param  p          the packet, restored from what was sent on (path = the hops that were left after this repeater)
 * \param  self_hash  at least p's path hash size bytes of this repeater's public key
 * \returns false (p untouched) if the packet is not a DIRECT packet of a type that may be flooded
 */
inline bool makeFloodFallback(Packet* p, const uint8_t* self_hash) {
  if (!p->isRouteDirect() || !isHopFallbackType(p->getPayloadType())) return false;
  uint8_t hsize = p->getPathHashSize();
  if (hsize == 0 || hsize > 3) return false;
  uint8_t route = p->hasTransportCodes() ? ROUTE_TYPE_TRANSPORT_FLOOD : ROUTE_TYPE_FLOOD;
  p->header &= ~PH_ROUTE_MASK;
  p->header |= route;
  memcpy(p->path, self_hash, hsize);
  p->setPathHashSizeAndCount(hsize, 1);
  return true;
}

}
