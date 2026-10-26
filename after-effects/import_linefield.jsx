// Import a LineField alpha render into After Effects and place it in the active comp (or a new one).
// File > Scripts > Run Script File… → pick this file → pick the .mov (ProRes 4444) or the first PNG of a sequence.
// ProRes 4444 / PNG carry straight alpha: AE reads it as "Straight – Unmatted"; we set that explicitly.
// The light looks most natural in Add or Screen mode over bright footage; Normal keeps the exact colours over dark plates.
(function () {
  var f = File.openDialog("Pick a LineField render (.mov or the first PNG of a sequence)");
  if (!f) return;
  app.beginUndoGroup("Import LineField");
  var isSeq = /\.png$/i.test(f.name);
  var io = new ImportOptions(f);
  if (isSeq) io.sequence = true;
  var item = app.project.importFile(io);
  item.mainSource.alphaMode = AlphaMode.STRAIGHT;
  if (isSeq) item.mainSource.conformFrameRate = 30;
  var comp = app.project.activeItem;
  if (!(comp instanceof CompItem)) comp = app.project.items.addComp(item.name.replace(/\.[^.]+$/, ""), item.width, item.height, 1, item.duration, item.frameRate || 30);
  var layer = comp.layers.add(item);
  layer.blendingMode = BlendingMode.ADD;
  layer.startTime = comp.time;   // drops in at the playhead
  var s = Math.min(comp.width / item.width, comp.height / item.height) * 100;
  if (s < 100) layer.property("Scale").setValue([s, s]);
  app.endUndoGroup();
  alert("LineField placed on '" + comp.name + "' at " + comp.time.toFixed(2) + " s (Add mode, straight alpha).");
})();
