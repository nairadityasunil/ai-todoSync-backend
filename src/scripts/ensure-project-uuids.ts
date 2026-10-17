import "dotenv/config";
import crypto from "node:crypto";
import mongoose from "mongoose";
import ProjectModel from "../modules/project/models/project.model.js";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Missing MONGODB_URI");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const rawProjects = await ProjectModel.collection.find({}).toArray();
  console.log(`Found ${rawProjects.length} projects in collection`);

  for (const p of rawProjects) {
    if (!p.uuid) {
      const generatedUuid = crypto.randomUUID();
      await ProjectModel.collection.updateOne(
        { _id: p._id },
        { $set: { uuid: generatedUuid } },
      );
      console.log(
        `Assigned persistent UUID ${generatedUuid} to project "${p.name}" (${p._id})`,
      );
    } else {
      console.log(`Project "${p.name}" (${p._id}) already has UUID: ${p.uuid}`);
    }
  }

  const verified = await ProjectModel.collection.find({}).toArray();
  console.log(
    "Verified projects:",
    verified.map((p) => ({ id: p._id.toString(), uuid: p.uuid, name: p.name })),
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
