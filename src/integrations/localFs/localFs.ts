import { loadNodeFromFs } from './loadNodeFromFs';
import { loadAllGraphsFromFs } from './loadAllGraphsFromFs.js';
import { loadGraphFromFs } from './loadGraphFromFs.js';
import { saveNodeToFs } from './saveNodeToFs.js';

export const localFs = {
  loadAllGraphsFromFs,
  loadGraphFromFs,
  loadNodeFromFs,
  saveNodeToFs,
}
