import { useEffect, useRef } from "react";
import {
  createTilePattern,
  type TilePattern,
} from "../lib/tile";
import type { GraphEdge, GraphNode } from "../types";

interface SimulationNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  pattern: TilePattern;
}

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  zoom: number;
  selectedId: string | null;
  recentConnection: {
    sourceId: string;
    targetId: string;
  } | null;
  onSelect: (node: GraphNode | null) => void;
}

function positionFromSeed(
  seed: string,
  span: number,
) {
  let value = 0;

  for (
    let index = 0;
    index < seed.length;
    index += 1
  ) {
    value =
      (value * 31 + seed.charCodeAt(index)) >>>
      0;
  }

  return (
    0.18 * span +
    ((value % 10_000) / 10_000) *
      span *
      0.64
  );
}

function applyForces(
  nodes: SimulationNode[],
  edges: GraphEdge[],
  width: number,
  height: number,
) {
  const lookup = new Map(
    nodes.map((node) => [node.id, node]),
  );

  const repulsion =
    nodes.length > 180
      ? 2500
      : 4200;

  for (
    let leftIndex = 0;
    leftIndex < nodes.length;
    leftIndex += 1
  ) {
    const left = nodes[leftIndex]!;

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < nodes.length;
      rightIndex += 1
    ) {
      const right =
        nodes[rightIndex]!;

      const dx =
        right.x - left.x || 0.01;

      const dy =
        right.y - left.y || 0.01;

      const distanceSquared = Math.max(
        dx * dx + dy * dy,
        100,
      );

      const force =
        repulsion /
        distanceSquared;

      const distance = Math.sqrt(
        distanceSquared,
      );

      const forceX =
        (dx / distance) * force;

      const forceY =
        (dy / distance) * force;

      left.vx -= forceX;
      left.vy -= forceY;

      right.vx += forceX;
      right.vy += forceY;
    }
  }

  const targetLength =
    Math.min(width, height) *
    (nodes.length > 100
      ? 0.075
      : 0.13);

  for (const edge of edges) {
    const source =
      lookup.get(edge.sourceId);

    const target =
      lookup.get(edge.targetId);

    if (!source || !target) {
      continue;
    }

    const dx =
      target.x - source.x;

    const dy =
      target.y - source.y;

    const distance = Math.max(
      Math.hypot(dx, dy),
      1,
    );

    const force =
      (distance - targetLength) *
      0.006;

    const forceX =
      (dx / distance) * force;

    const forceY =
      (dy / distance) * force;

    source.vx += forceX;
    source.vy += forceY;

    target.vx -= forceX;
    target.vy -= forceY;
  }

  for (const node of nodes) {
    node.vx +=
      (width / 2 - node.x) *
      0.0008;

    node.vy +=
      (height / 2 - node.y) *
      0.0008;

    node.vx *= 0.84;
    node.vy *= 0.84;

    const speed = Math.hypot(
      node.vx,
      node.vy,
    );

    if (speed > 7) {
      node.vx =
        (node.vx / speed) * 7;

      node.vy =
        (node.vy / speed) * 7;
    }

    node.x = Math.max(
      32,
      Math.min(
        width - 32,
        node.x + node.vx,
      ),
    );

    node.y = Math.max(
      32,
      Math.min(
        height - 32,
        node.y + node.vy,
      ),
    );
  }
}

function drawTile(
  context: CanvasRenderingContext2D,
  node: SimulationNode,
  size: number,
) {
  const [
    background,
    motif,
  ] = node.pattern.palette;

  const left =
    node.x - size / 2;

  const top =
    node.y - size / 2;

  /*
   * Square quilt background.
   */
  context.fillStyle =
    background;

  context.fillRect(
    left,
    top,
    size,
    size,
  );

  /*
   * 8x8 circular-dot mandala.
   */
  const patternSize = 8;

  const area =
    size * 0.9;

  const step =
    area / patternSize;

  const radius =
    step * 0.46;

  const startX =
    node.x -
    area / 2 +
    step / 2;

  const startY =
    node.y -
    area / 2 +
    step / 2;

  context.fillStyle = motif;

  for (
    let y = 0;
    y < patternSize;
    y += 1
  ) {
    for (
      let x = 0;
      x < patternSize;
      x += 1
    ) {
      if (
        !node.pattern.cells[y]![x]
      ) {
        continue;
      }

      context.beginPath();

      context.arc(
        startX + x * step,
        startY + y * step,
        radius,
        0,
        Math.PI * 2,
      );

      context.fill();
    }
  }
}

export function GraphCanvas({
  nodes,
  edges,
  zoom,
  selectedId,
  recentConnection,
  onSelect,
}: GraphCanvasProps) {
  const canvasRef =
    useRef<HTMLCanvasElement>(
      null,
    );

  const simulationRef =
    useRef<SimulationNode[]>(
      [],
    );

  const sizeRef =
    useRef({
      width: 1,
      height: 1,
    });

  const propsRef = useRef({
    edges,
    zoom,
    selectedId,
    recentConnection,
    onSelect,
  });

  propsRef.current = {
    edges,
    zoom,
    selectedId,
    recentConnection,
    onSelect,
  };

  /*
   * Synchronize graph data into
   * our simulation nodes.
   *
   * Existing nodes keep their
   * position and palette.
   *
   * New nodes get a palette that
   * considers nearby nodes.
   */
  useEffect(() => {
    const previous =
      new Map(
        simulationRef.current.map(
          (node) => [
            node.id,
            node,
          ],
        ),
      );

    const {
      width,
      height,
    } = sizeRef.current;

    const nextSimulation:
      SimulationNode[] = [];

    for (
      const [
        index,
        node,
      ] of nodes.entries()
    ) {
      const existing =
        previous.get(
          node.id,
        );

      if (existing) {
        nextSimulation.push({
          ...existing,
          ...node,
        });

        continue;
      }

      const x =
        positionFromSeed(
          `${node.visualSeed}-x-${index}`,
          width,
        );

      const y =
        positionFromSeed(
          `${node.visualSeed}-y-${index}`,
          height,
        );

      nextSimulation.push({
        ...node,

        x,
        y,

        vx: 0,
        vy: 0,

        pattern: createTilePattern(
          node.visualSeed,
        ),
      });
    }

    simulationRef.current =
      nextSimulation;

    /*
     * Preserve the existing force
     * layout behavior.
     */
    for (
      let iteration = 0;
      iteration < 120;
      iteration += 1
    ) {
      applyForces(
        simulationRef.current,
        edges,
        width,
        height,
      );
    }
  }, [edges, nodes]);

  useEffect(() => {
    const canvas =
      canvasRef.current;

    if (!canvas) {
      return;
    }

    const context =
      canvas.getContext("2d");

    if (!context) {
      return;
    }

    const resize = () => {
      const bounds =
        canvas.getBoundingClientRect();

      const ratio =
        Math.min(
          window.devicePixelRatio ||
            1,
          2,
        );

      sizeRef.current = {
        width: bounds.width,
        height: bounds.height,
      };

      canvas.width =
        Math.round(
          bounds.width * ratio,
        );

      canvas.height =
        Math.round(
          bounds.height * ratio,
        );

      context.setTransform(
        ratio,
        0,
        0,
        ratio,
        0,
        0,
      );
    };

    resize();

    const resizeObserver =
      new ResizeObserver(
        resize,
      );

    resizeObserver.observe(
      canvas,
    );

    let animationFrame = 0;

    const render = () => {
      const {
        width,
        height,
      } = sizeRef.current;

      const current =
        propsRef.current;

      const simulationNodes =
        simulationRef.current;

      const lookup =
        new Map(
          simulationNodes.map(
            (node) => [
              node.id,
              node,
            ],
          ),
        );

      const iterations =
        simulationNodes.length >
        160
          ? 1
          : 2;

      for (
        let iteration = 0;
        iteration < iterations;
        iteration += 1
      ) {
        applyForces(
          simulationNodes,
          current.edges,
          width,
          height,
        );
      }

      context.clearRect(
        0,
        0,
        width,
        height,
      );

      const recentIds =
        new Set(
          current.recentConnection
            ? [
                current
                  .recentConnection
                  .sourceId,
                current
                  .recentConnection
                  .targetId,
              ]
            : [],
        );

      context.save();
      context.translate(
        width / 2,
        height / 2,
      );
      context.scale(
        current.zoom,
        current.zoom,
      );
      context.translate(
        -width / 2,
        -height / 2,
      );

      /*
       * Draw real graph edges.
       */
      for (
        const edge
        of current.edges
      ) {
        const source =
          lookup.get(
            edge.sourceId,
          );

        const target =
          lookup.get(
            edge.targetId,
          );

        if (
          !source ||
          !target
        ) {
          continue;
        }

        const isRecent =
          current
            .recentConnection
            ?.sourceId ===
            edge.sourceId &&
          current
            .recentConnection
            ?.targetId ===
            edge.targetId;

        const isSelected =
          edge.sourceId ===
            current.selectedId ||
          edge.targetId ===
            current.selectedId;

        context.beginPath();

        context.moveTo(
          source.x,
          source.y,
        );

        context.lineTo(
          target.x,
          target.y,
        );

        /* Short rounded dashes read like thread stitches between badges. */
        context.setLineDash(
          isRecent
            ? [5, 5]
            : isSelected
              ? [4, 6]
              : [3, 7],
        );
        context.lineDashOffset = isRecent
          ? -(performance.now() / 45) % 10
          : 0;
        context.lineCap = "round";

        context.strokeStyle =
          isRecent
            ? "rgba(36, 60, 115, 0.95)"
            : isSelected
              ? "rgba(36, 60, 115, 0.72)"
              : "rgba(36, 60, 115, 0.24)";

        context.lineWidth =
          isRecent
            ? 2.5
            : isSelected
              ? 1.5
              : Math.max(
                  0.45,
                  1.2 -
                    current
                      .edges
                      .length /
                      350,
                );

        context.stroke();
      }

      context.setLineDash([]);
      context.lineDashOffset = 0;
      context.lineCap = "butt";

      const tileSize =
        simulationNodes.length >
        220
          ? 20
          : simulationNodes.length >
              100
            ? 26
            : 34;

      /*
       * Draw quilt badges.
       */
      for (
        const node
        of simulationNodes
      ) {
        const emphasized =
          node.id ===
            current.selectedId ||
          recentIds.has(
            node.id,
          );

        if (emphasized) {
          const pulse =
            5 +
            Math.sin(
              performance.now() /
                180,
            ) *
              2;

          context.fillStyle =
            recentIds.has(
              node.id,
            )
              ? "rgba(242, 169, 59, 0.18)"
              : "rgba(167, 139, 250, 0.18)";

          context.fillRect(
            node.x -
              tileSize / 2 -
              pulse,
            node.y -
              tileSize / 2 -
              pulse,
            tileSize +
              pulse * 2,
            tileSize +
              pulse * 2,
          );
        }

        drawTile(
          context,
          node,
          tileSize,
        );

        if (emphasized) {
          context.font =
            "600 12px 'IBM Plex Mono', monospace";

          context.textAlign =
            "center";

          context.fillStyle =
            "#edeafb";

          context.fillText(
            node.displayName,
            node.x,
            node.y +
              tileSize / 2 +
              18,
          );
        }
      }

      context.restore();

      animationFrame =
        requestAnimationFrame(
          render,
        );
    };

    animationFrame =
      requestAnimationFrame(
        render,
      );

    const selectNode = (
      event: PointerEvent,
    ) => {
      const bounds =
        canvas.getBoundingClientRect();

      const screenX =
        event.clientX - bounds.left;
      const screenY =
        event.clientY - bounds.top;
      const currentZoom =
        propsRef.current.zoom;
      const x =
        bounds.width / 2 +
        (screenX - bounds.width / 2) /
          currentZoom;
      const y =
        bounds.height / 2 +
        (screenY - bounds.height / 2) /
          currentZoom;

      let closest:
        | SimulationNode
        | null = null;

      let closestDistance =
        30 / currentZoom;

      for (
        const node
        of simulationRef.current
      ) {
        const distance =
          Math.hypot(
            node.x - x,
            node.y - y,
          );

        if (
          distance <
          closestDistance
        ) {
          closest = node;
          closestDistance =
            distance;
        }
      }

      propsRef.current.onSelect(
        closest,
      );
    };

    canvas.addEventListener(
      "pointerdown",
      selectNode,
    );

    return () => {
      cancelAnimationFrame(
        animationFrame,
      );

      resizeObserver.disconnect();

      canvas.removeEventListener(
        "pointerdown",
        selectNode,
      );
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="graph-canvas"
      aria-label="Live attendee connection mosaic"
    />
  );
}
