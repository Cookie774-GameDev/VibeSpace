import { BOTANICAL_SECTION_HEIGHT, botanicalRandom, botanicalSections } from '../chat/chatBotanicalPattern';

export interface RelayFlowerSpec {
  x: number;
  y: number;
  radius: number;
  petals: number;
  rotation: number;
  fullness: number;
  shade: number;
  stemLength: number;
  stemBend: number;
  stemAngle: number;
  thorns: number;
}

/** The chat botanical canvas's coordinate-seeded sections, with a different bloom at each coordinate. */
export function relayFlowerSpecs(seed: string, width: number, height: number, scrollTop: number): RelayFlowerSpec[] {
  if (width <= 0 || height <= 0) return [];
  const flowers: RelayFlowerSpec[] = [];
  for (const section of botanicalSections(scrollTop, height)) {
    for (const side of [0, 1]) {
      const random = botanicalRandom(`relay-flowers:${seed}`, section, side);
      const count = 2;
      for (let index = 0; index < count; index++) {
        const radius = 21 + random() * 35;
        const edge = 14 + random() * Math.min(width * .27, 86);
        flowers.push({
          x: side ? width - edge : edge,
          y: section * BOTANICAL_SECTION_HEIGHT + 86 + index * 220 + (random() - .5) * 136 - scrollTop,
          radius,
          petals: 5 + Math.floor(random() * 5),
          rotation: random() * Math.PI * 2,
          fullness: .68 + random() * .48,
          shade: random(),
          stemLength: 47 + random() * 105,
          stemBend: (random() - .5) * 58,
          stemAngle: (random() - .5) * .65,
          thorns: 1 + Math.floor(random() * 5),
        });
      }
    }
  }
  return flowers.filter((flower) => flower.y + flower.radius > 0 && flower.y - flower.radius < height);
}

export function paintRelayFlowers(
  ctx: CanvasRenderingContext2D, seed: string, width: number, height: number, scrollTop: number,
) {
  ctx.clearRect(0, 0, width, height);
  for (const flower of relayFlowerSpecs(seed, width, height, scrollTop)) {
    ctx.save();
    ctx.translate(flower.x, flower.y);
    // Stems grow down from the bloom; each has its own curve, length, angle and thorns.
    ctx.save();
    ctx.rotate(flower.stemAngle);
    ctx.strokeStyle = '#778383';
    ctx.fillStyle = '#879392';
    ctx.lineWidth = 1.2 + flower.shade * .55;
    ctx.globalAlpha = .3 + flower.shade * .08;
    ctx.beginPath();
    ctx.moveTo(0, flower.radius * .12);
    ctx.quadraticCurveTo(flower.stemBend * .2, flower.stemLength * .48,
      flower.stemBend, flower.stemLength);
    ctx.stroke();
    for (let thorn = 0; thorn < flower.thorns; thorn++) {
      const t = (thorn + 1) / (flower.thorns + 1);
      const y = flower.radius * .12 + (flower.stemLength - flower.radius * .12) * t;
      const x = flower.stemBend * t * t;
      const direction = thorn % 2 ? -1 : 1;
      const length = 4 + ((flower.shade * 11 + thorn * 3) % 6);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + direction * length, y - length * (.7 + t * .3));
      ctx.lineTo(x + direction * 1.4, y + 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.rotate(flower.rotation);
    const petalRadius = flower.radius * (.64 + flower.shade * .16);
    const petalWidth = flower.radius * (.32 + flower.fullness * .12);
    for (let petal = 0; petal < flower.petals; petal++) {
      ctx.save();
      ctx.rotate(petal * Math.PI * 2 / flower.petals);
      const wash = ctx.createRadialGradient(0, -petalRadius * .55, 1, 0, -petalRadius * .55, petalRadius);
      wash.addColorStop(0, '#ffffff');
      wash.addColorStop(.48, flower.shade > .5 ? '#d1d2d0' : '#d8d8d5');
      wash.addColorStop(1, '#8f9699');
      ctx.fillStyle = wash;
      ctx.strokeStyle = '#92989a';
      ctx.globalAlpha = .19 + flower.shade * .09;
      ctx.lineWidth = .8;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-petalWidth * 1.4, -petalRadius * .42, -petalWidth, -petalRadius * 1.25, 0, -flower.radius);
      ctx.bezierCurveTo(petalWidth, -petalRadius * 1.25, petalWidth * 1.4, -petalRadius * .42, 0, 0);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = .2;
      ctx.beginPath();
      ctx.moveTo(0, -flower.radius * .16);
      ctx.quadraticCurveTo(petalWidth * .25, -flower.radius * .58, 0, -flower.radius * .82);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = .39;
    ctx.fillStyle = '#a2a9a8';
    ctx.beginPath();
    ctx.arc(0, 0, flower.radius * .18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f7f7f4';
    for (let dot = 0; dot < flower.petals; dot++) {
      const angle = dot * Math.PI * 2 / flower.petals;
      ctx.beginPath();
      ctx.arc(Math.cos(angle) * flower.radius * .095, Math.sin(angle) * flower.radius * .095, 1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
