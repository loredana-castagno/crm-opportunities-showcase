import { NextRequest, NextResponse } from "next/server";
import { saveFile } from "@/app/lib/files";

const ALLOWED_EXTENSIONS = ["pdf", "doc", "docx"];

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;

        if (!file || file.size === 0) {
            console.error("[upload-opp-doc] No file in request");
            return NextResponse.json({ error: "No file provided" }, { status: 400 });
        }

        const ext = file.name.split(".").pop()?.toLowerCase();
        if (!ext || !ALLOWED_EXTENSIONS.includes(ext)) {
            console.error("[upload-opp-doc] Unsupported file type:", file.name);
            return NextResponse.json(
                { error: `Only ${ALLOWED_EXTENSIONS.join(", ")} files are allowed` },
                { status: 400 }
            );
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const url = await saveFile(buffer, file.name);

        console.log("[upload-opp-doc] Saved:", url);
        return NextResponse.json({ url, name: file.name });
    } catch (error) {
        console.error("[upload-opp-doc] Error:", error);
        return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
}
