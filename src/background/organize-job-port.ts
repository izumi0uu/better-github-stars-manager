import {
  validateBgsmOrganizeJobDeliveryEnvelope,
  validateBgsmOrganizeJobMessageIdentity,
  type BgsmOrganizeJobControllerIdentity,
  type BgsmOrganizeJobDeliveryEnvelope,
  type BgsmOrganizeJobDeliveryKind,
  type BgsmOrganizeJobServerMessage,
} from '@/utils/messaging';

export type BgsmOrganizeJobPortLike = Readonly<{
  postMessage(message: BgsmOrganizeJobDeliveryEnvelope): void;
}>;

export type BgsmOrganizeJobConnection<Port extends BgsmOrganizeJobPortLike = BgsmOrganizeJobPortLike> = Readonly<{
  port: Port;
  connectionEpochId: string;
  identity: BgsmOrganizeJobControllerIdentity;
}>;

type MutableConnection<Port extends BgsmOrganizeJobPortLike> = {
  port: Port;
  connectionEpochId: string;
  identity: BgsmOrganizeJobControllerIdentity;
  nextDeliverySequence: number;
  disconnected: boolean;
};

export type BgsmOrganizeJobConnectionBindResult<Port extends BgsmOrganizeJobPortLike> = Readonly<{
  status: 'bound' | 'current' | 'stale' | 'identity_mismatch';
  connection: BgsmOrganizeJobConnection<Port>;
}>;

export function createBgsmOrganizeJobConnectionRegistry<Port extends BgsmOrganizeJobPortLike>(
  input: Readonly<{ randomId?: () => string }> = {},
) {
  const randomId = input.randomId ?? (() => globalThis.crypto.randomUUID());
  const currentByIdentity = new Map<string, MutableConnection<Port>>();
  const connectionByPort = new Map<Port, MutableConnection<Port>>();

  const bind = (
    port: Port,
    identity: BgsmOrganizeJobControllerIdentity,
  ): BgsmOrganizeJobConnectionBindResult<Port> => {
    assertIdentity(identity);
    const existing = connectionByPort.get(port);
    if (existing) {
      if (connectionKey(existing.identity) !== connectionKey(identity)) {
        return Object.freeze({ status: 'identity_mismatch', connection: existing });
      }
      return Object.freeze({
        status: currentByIdentity.get(connectionKey(identity)) === existing && !existing.disconnected
          ? 'current'
          : 'stale',
        connection: existing,
      });
    }

    const connection: MutableConnection<Port> = {
      port,
      connectionEpochId: `organize-connection:v1:${randomId()}`,
      identity: Object.freeze({ ...identity }),
      nextDeliverySequence: 0,
      disconnected: false,
    };
    connectionByPort.set(port, connection);
    currentByIdentity.set(connectionKey(identity), connection);
    return Object.freeze({ status: 'bound', connection });
  };

  const ownsIdentity = (connection: BgsmOrganizeJobConnection<Port>): boolean => (
    currentByIdentity.get(connectionKey(connection.identity)) === connection
  );

  return Object.freeze({
    bind,

    current(identity: BgsmOrganizeJobControllerIdentity): BgsmOrganizeJobConnection<Port> | null {
      const connection = currentByIdentity.get(connectionKey(identity));
      return connection && !connection.disconnected ? connection : null;
    },

    forPort(port: Port): BgsmOrganizeJobConnection<Port> | null {
      return connectionByPort.get(port) ?? null;
    },

    ownsIdentity,

    markDisconnected(port: Port): BgsmOrganizeJobConnection<Port> | null {
      const connection = connectionByPort.get(port);
      if (!connection) return null;
      connection.disconnected = true;
      return connection;
    },

    release(connection: BgsmOrganizeJobConnection<Port>): boolean {
      const key = connectionKey(connection.identity);
      connectionByPort.delete(connection.port);
      if (currentByIdentity.get(key) !== connection) return false;
      currentByIdentity.delete(key);
      return true;
    },

    post(
      port: Port,
      message: BgsmOrganizeJobServerMessage,
      delivery: Readonly<{
        kind?: BgsmOrganizeJobDeliveryKind;
        durableRevision?: number | null;
      }> = {},
    ): BgsmOrganizeJobDeliveryEnvelope | null {
      const connection = connectionByPort.get(port);
      if (!connection || connection.disconnected || !ownsIdentity(connection)) return null;
      validateBgsmOrganizeJobMessageIdentity(message);
      const envelope: BgsmOrganizeJobDeliveryEnvelope = Object.freeze({
        type: 'bgsmOrganizeJobRunDelivery',
        connectionEpochId: connection.connectionEpochId,
        deliverySequence: connection.nextDeliverySequence,
        deliveryKind: delivery.kind ?? 'live',
        durableRevision: delivery.durableRevision ?? null,
        message,
      });
      validateBgsmOrganizeJobDeliveryEnvelope(envelope);
      try {
        port.postMessage(envelope);
      } catch {
        connection.disconnected = true;
        return null;
      }
      connection.nextDeliverySequence += 1;
      return envelope;
    },
  });
}

function connectionKey(identity: BgsmOrganizeJobControllerIdentity): string {
  return `${identity.controllerId}\u0000${identity.sessionId}`;
}

function assertIdentity(identity: BgsmOrganizeJobControllerIdentity): void {
  if (
    !identity.controllerId
    || identity.controllerId.trim() !== identity.controllerId
    || !identity.sessionId
    || identity.sessionId.trim() !== identity.sessionId
  ) {
    throw new TypeError('OrganizeJobRun connection identity is malformed.');
  }
}
