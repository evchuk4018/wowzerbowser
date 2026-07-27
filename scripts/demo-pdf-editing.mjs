import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const code = "import hashlib,os,sys,json\\ntry:\\n import fitz\\n from reportlab.pdfgen import canvas\\nexcept ImportError as error:\\n print(json.dumps({'error':'PDF runtime unavailable: '+str(error)}));sys.exit(2)\\nr=sys.argv[1];o=os.path.join(r,'original.pdf');e=os.path.join(r,'edited.pdf');c=canvas.Canvas(o);c.drawString(72,760,'Original Title');c.showPage();c.drawString(72,760,'Invoice 1001');c.showPage();c.drawString(72,760,'Third page');c.save();h=hashlib.sha256(open(o,'rb').read()).hexdigest();d=fitz.open(o);p=d[0];q=p.search_for('Original Title');assert len(q)==1;p.add_redact_annot(q[0],fill=(1,1,1));p.apply_redactions();p.insert_textbox(q[0],'Edited Title',fontsize=11);d.delete_page(1);d[1].set_rotation(90);d.save(e);d.close();n=fitz.open(e);assert len(n)==2 and 'Edited Title' in ''.join(x.get_text() for x in n);n.close();assert hashlib.sha256(open(o,'rb').read()).hexdigest()==h;print(json.dumps({'pages':2,'originalUnchanged':True}))";
const directory = await mkdtemp(join(tmpdir(), "wowzerbowser-pdf-demo-"));
try {
  const result = await run("python", ["-c", code, directory], { windowsHide: true });
  console.log(result.stdout.trim());
} catch (error) {
  console.error(error?.stdout?.trim() || error?.message || "PDF demo failed.");
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}

