// earcut 3 bringt keine Typen mit
declare module "earcut" {
  export default function earcut(data: ArrayLike<number>, holeIndices?: ArrayLike<number> | null, dim?: number): number[];
}
