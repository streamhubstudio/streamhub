/**
 * COCO class list + (de)serialization helpers for the YOLO plugin config.
 *
 * PURE — no React/DOM — so it is unit-tested with node:test (see
 * src/plugins/yolo.spec.ts). The backend stores the class filter as a
 * comma-separated string under the `classes` config key; the custom config
 * editor renders a multiselect and (de)serializes through here.
 */

/** The 80 COCO classes, canonical ultralytics order (index === class id). */
export const COCO_CLASSES: readonly string[] = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train',
  'truck', 'boat', 'traffic light', 'fire hydrant', 'stop sign',
  'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag',
  'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite',
  'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana',
  'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza',
  'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed', 'dining table',
  'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
  'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock',
  'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
]

/** Model-size choices (match the backend `model` select values). */
export const MODEL_SIZES = ['nano', 'small', 'medium', 'large', 'xlarge'] as const

const KNOWN = new Set(COCO_CLASSES)

/** Parse a stored `classes` CSV into a clean, de-duped, known-only name list. */
export function parseClasses(csv: string | undefined | null): string[] {
  if (!csv) return []
  const seen = new Set<string>()
  for (const raw of csv.split(',')) {
    const name = raw.trim().toLowerCase()
    if (name && KNOWN.has(name)) seen.add(name)
  }
  return [...seen]
}

/**
 * Serialize a selected-name list back to the stored CSV, preserving canonical
 * COCO order (so the value is stable regardless of click order). An empty
 * selection serializes to '' — meaning "all classes".
 */
export function serializeClasses(selected: Iterable<string>): string {
  const set = new Set<string>()
  for (const n of selected) {
    const name = n.trim().toLowerCase()
    if (KNOWN.has(name)) set.add(name)
  }
  return COCO_CLASSES.filter((c) => set.has(c)).join(',')
}

/** Toggle a single class in a selection, returning the new CSV. */
export function toggleClass(csv: string | undefined | null, name: string): string {
  const cur = new Set(parseClasses(csv))
  const key = name.trim().toLowerCase()
  if (cur.has(key)) cur.delete(key)
  else if (KNOWN.has(key)) cur.add(key)
  return serializeClasses(cur)
}
