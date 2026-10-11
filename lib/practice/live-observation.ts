/** Request order is transport freshness, separate from Kubernetes health. */
export type ObservationIdentity = {
  id: string;
  generation: number;
  revision: number;
} | null;
export function acceptsObservation(
  current: ObservationIdentity,
  incoming: ObservationIdentity,
  requestSequence: number,
  acceptedSequence: number,
): boolean {
  if (current && incoming && current.id === incoming.id) {
    if (incoming.generation !== current.generation)
      return incoming.generation > current.generation;
    if (incoming.revision !== current.revision)
      return incoming.revision > current.revision;
  }
  return requestSequence >= acceptedSequence;
}
