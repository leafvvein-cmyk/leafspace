export function validPosition(value) {
  return Boolean(value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.generation)
    && typeof value.seq === 'string' && /^(0|[1-9]\d{0,18})$/.test(value.seq) && BigInt(value.seq) <= 9223372036854775807n);
}

export function includesPosition(snapshot, acknowledged) {
  return validPosition(snapshot) && validPosition(acknowledged) && snapshot.generation === acknowledged.generation
    && BigInt(snapshot.seq) >= BigInt(acknowledged.seq);
}
