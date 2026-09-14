/**
 * The connect offer's decision contract — a pure fold, not a snapshot.
 *
 * `foldConstellation` already answers which node is live (`truth`); this
 * suite pins the layer the map adds on top: tapping a saved node presents
 * "connect", the live node is not a button to itself, a mid-handshake
 * handshake shows its honest label and refuses a re-tap, and a failed
 * connect surfaces the humanized cause line — never a raw exception.
 *
 * File written FIRST — RED via LSP before `src/lib/fleet/connect-offer.ts`
 * existed (no exported member named `constellationConnectOffer`).
 */

import { foldConstellation } from '@/lib/fleet/constellation-model';
import {
  constellationConnectOffer,
} from '@/lib/fleet/connect-offer';
import type { GatewayProfile } from '@/lib/gateway/types';

const PROFILES: GatewayProfile[] = [
  { id: 'gw-live', name: 'Hermes PC', url: 'https://pc.example' },
  { id: 'gw-saved', name: 'Studio rig', url: 'https://studio.example' },
] as GatewayProfile[];

/** The classes the map's own fold answers for the two saved profiles. */
function classesFor(status: 'connected' | 'connecting' | 'pairing' | 'disconnected') {
  const model = foldConstellation({
    profiles: PROFILES,
    reachability: {},
    activeGatewayId: 'gw-live',
    status,
    width: 400,
    height: 400,
    now: 0,
  });
  return new Map(model.gateways.map((node) => [node.gatewayId, node.truth] as const));
}

describe('constellation connect offer', () => {
  it('a connected gateway is not a button to itself', () => {
    const classes = classesFor('connected');
    const offer = constellationConnectOffer({
      truth: classes.get('gw-live')!,
      gatewayId: 'gw-live',
      status: 'connected',
      handshakeTargetId: null,
      failureCause: null,
    });
    expect(offer.offer).toBe(false);
    expect(offer.tappable).toBe(false);
  });

  it('a saved gateway offers Connect, tappable', () => {
    const classes = classesFor('connected');
    const offer = constellationConnectOffer({
      truth: classes.get('gw-saved')!,
      gatewayId: 'gw-saved',
      status: 'connected',
      handshakeTargetId: null,
      failureCause: null,
    });
    expect(offer.offer).toBe(true);
    expect(offer.tappable).toBe(true);
    expect(offer.label).toBe('Connect');
    expect(offer.detail).toBeUndefined();
  });

  it('a mid-handshake handshake shows its honest label and refuses a re-tap', () => {
    for (const status of ['connecting', 'reconnecting', 'pairing'] as const) {
      const offer = constellationConnectOffer({
        truth: 'saved',
        gatewayId: 'gw-saved',
        status,
        handshakeTargetId: 'gw-saved',
        failureCause: null,
      });
      expect(offer.offer).toBe(true);
      expect(offer.tappable).toBe(false);
      expect(offer.label).not.toBe('Connect');
    }
    // The words are the ConnectionBadge vocabulary, so the map never speaks
    // a second language for the same state.
    expect(
      constellationConnectOffer({
        truth: 'saved',
        gatewayId: 'gw-saved',
        status: 'pairing',
        handshakeTargetId: 'gw-saved',
        failureCause: null,
      }).label,
    ).toBe('Needs approval');
  });

  it('the in-flight refusal is scoped to the handshake target, not every node', () => {
    const offer = constellationConnectOffer({
      truth: 'saved',
      gatewayId: 'gw-other',
      status: 'connecting',
      handshakeTargetId: 'gw-saved',
      failureCause: null,
    });
    // A different saved gateway stays tappable while another one connects.
    expect(offer.tappable).toBe(true);
    expect(offer.label).toBe('Connect');
  });

  it('a failed connect surfaces the humanized cause at the sheet', () => {
    const offer = constellationConnectOffer({
      truth: 'saved',
      gatewayId: 'gw-saved',
      status: 'disconnected',
      handshakeTargetId: null,
      failureCause: 'The API key or token was refused.',
    });
    expect(offer.detail).toBe('The API key or token was refused.');
    // A failure does not take the offer away — the retry is the point.
    expect(offer.tappable).toBe(true);
    expect(offer.label).toBe('Connect');
  });

  it('no failure means no detail line', () => {
    const offer = constellationConnectOffer({
      truth: 'saved',
      gatewayId: 'gw-saved',
      status: 'disconnected',
      handshakeTargetId: null,
      failureCause: null,
    });
    expect(offer.detail).toBeUndefined();
  });

  it('mid-handshake titles keep out of the saved node otherwise', () => {
    // A rail that is connecting to the ACTIVE gateway must not dim the offer
    // on an unrelated SAVED node: the handshake belongs to the one target.
    const offer = constellationConnectOffer({
      truth: 'saved',
      gatewayId: 'gw-saved',
      status: 'connecting',
      handshakeTargetId: 'gw-live',
      failureCause: null,
    });
    expect(offer.tappable).toBe(true);
  });
});
