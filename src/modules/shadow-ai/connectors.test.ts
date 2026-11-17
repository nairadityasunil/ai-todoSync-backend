import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, it } from "node:test";

import {
  googleAssertion,
  parseGoogleKey,
  pullAws,
  pullAzure,
  pullGoogle,
  pullMicrosoft,
  signAws,
  type Endpoints,
  type Fetch,
} from "./connectors.js";

const EP: Endpoints = {
  googleToken: "https://g.test/token",
  googleDirectory: "https://g.test/dir",
  microsoftLogin: "https://m.test",
  microsoftGraph: "https://m.test/graph",
  azureArm: "https://a.test",
  awsOverride: "https://aws.test",
};
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("google connector", () => {
  const creds = {
    serviceAccountEmail: "sa@proj.iam.gserviceaccount.com",
    privateKey: pem,
    adminEmail: "admin@corp.com",
  };
  it("signs a verifiable assertion that acts as the admin", () => {
    const jwt = googleAssertion(creds, EP.googleToken, 1_700_000_000);
    const [h, c, sig] = jwt.split(".");
    assert.ok(
      createVerify("RSA-SHA256")
        .update(`${h}.${c}`)
        .verify(publicKey, Buffer.from(sig, "base64url")),
    );
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    assert.equal(claims.sub, "admin@corp.com");
    assert.equal(claims.iss, creds.serviceAccountEmail);
    assert.match(claims.scope, /admin\.directory\.user\.security/);
  });
  it("lists users across pages, skips suspended ones and returns each app with its scopes", async () => {
    const f: Fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.href === EP.googleToken) {
        assert.match(String(init?.body), /assertion=/);
        return reply({ access_token: "tok" });
      }
      assert.equal(
        (init?.headers as Record<string, string>).authorization,
        "Bearer tok",
      );
      if (url.pathname === "/dir/users")
        return url.searchParams.get("pageToken")
          ? reply({ users: [{ primaryEmail: "bob@corp.com" }] })
          : reply({
              users: [
                { primaryEmail: "ada@corp.com" },
                { primaryEmail: "gone@corp.com", suspended: true },
              ],
              nextPageToken: "p2",
            });
      const who = decodeURIComponent(url.pathname.split("/")[3]);
      return reply({
        items:
          who === "ada@corp.com"
            ? [{ displayText: "Otter.ai", scopes: ["calendar"] }]
            : [],
      });
    };
    const r = await pullGoogle(creds, EP, f);
    assert.equal(r.users, 2);
    assert.deepEqual(r.signals, [
      { target: "Otter.ai", user: "ada@corp.com", scopes: ["calendar"] },
    ]);
  });
  it("explains a refused sign-in without echoing credentials", async () => {
    const f: Fetch = async () =>
      reply(
        {
          error: "unauthorized_client",
          error_description: "Client is unauthorized to retrieve access tokens",
        },
        401,
      );
    await assert.rejects(
      pullGoogle(creds, EP, f),
      (e: Error) =>
        /unauthorized/.test(e.message) && !e.message.includes("PRIVATE KEY"),
    );
  });
  it("fails loudly when delegation is missing for every user, not silently with no findings", async () => {
    const f: Fetch = async (input) => {
      const url = new URL(String(input));
      if (url.href === EP.googleToken) return reply({ access_token: "t" });
      if (url.pathname === "/dir/users")
        return reply({
          users: [
            { primaryEmail: "a@corp.com" },
            { primaryEmail: "b@corp.com" },
          ],
        });
      return reply(
        { error: { message: "Not Authorized to access this resource/api" } },
        403,
      );
    };
    await assert.rejects(pullGoogle(creds, EP, f), /Not Authorized/);
  });
  it("rejects a file that is not a service account key", () => {
    assert.throws(() => parseGoogleKey("nope"), /not valid JSON/);
    assert.throws(() => parseGoogleKey("{}"), /service account/);
    assert.equal(
      parseGoogleKey(
        JSON.stringify({
          client_email: "a@b.iam.gserviceaccount.com",
          private_key: pem,
        }),
      ).serviceAccountEmail,
      "a@b.iam.gserviceaccount.com",
    );
  });
});

describe("microsoft connector", () => {
  const creds = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    clientId: "app",
    clientSecret: "s3cret-value",
  };
  it("maps grants to app names and people, follows pages, and leaves org-wide grants unattributed", async () => {
    const f: Fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/oauth2/v2.0/token")) {
        assert.match(String(init?.body), /client_credentials/);
        return reply({ access_token: "t" });
      }
      if (url.includes("/oauth2PermissionGrants")) {
        return url.includes("page=2")
          ? reply({
              value: [
                {
                  clientId: "sp2",
                  consentType: "AllPrincipals",
                  scope: "Mail.Read Files.Read.All",
                },
              ],
            })
          : reply({
              value: [
                {
                  clientId: "sp1",
                  consentType: "Principal",
                  principalId: "u1",
                  scope: "Calendars.Read offline_access",
                },
              ],
              "@odata.nextLink": `${EP.microsoftGraph}/oauth2PermissionGrants?page=2`,
            });
      }
      if (url.includes("/servicePrincipals"))
        return reply({
          value: [
            { id: "sp1", displayName: "Fireflies.ai" },
            { id: "sp2", displayName: "Acme AI Notes" },
          ],
        });
      if (url.includes("/users/u1")) return reply({ mail: "Ada@Corp.com" });
      throw new Error("unexpected " + url);
    };
    const r = await pullMicrosoft(creds, EP, f);
    assert.deepEqual(r.signals, [
      {
        target: "Fireflies.ai",
        user: "ada@corp.com",
        scopes: ["Calendars.Read", "offline_access"],
      },
      {
        target: "Acme AI Notes",
        user: undefined,
        scopes: ["Mail.Read", "Files.Read.All"],
      },
    ]);
  });
  it("refuses a malformed tenant and reports a bad secret without echoing it", async () => {
    await assert.rejects(
      pullMicrosoft({ ...creds, tenantId: "bad tenant/../x" }, EP, async () =>
        reply({}),
      ),
      /tenant/,
    );
    const f: Fetch = async () =>
      reply(
        {
          error: "invalid_client",
          error_description: "Invalid client secret provided",
        },
        401,
      );
    await assert.rejects(
      pullMicrosoft(creds, EP, f),
      (e: Error) =>
        /Invalid client secret/.test(e.message) &&
        !e.message.includes("s3cret-value"),
    );
  });
});

describe("aws signing", () => {
  it("matches AWS's published Signature V4 test vector (get-vanilla)", () => {
    const h = signAws({
      method: "GET",
      url: new URL("https://example.amazonaws.com/"),
      service: "service",
      region: "us-east-1",
      body: "",
      creds: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
      now: new Date("2015-08-30T12:36:00Z"),
      payloadHeader: false,
    });
    assert.equal(
      h.authorization,
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });
});

describe("azure connector", () => {
  const creds = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    clientId: "app",
    clientSecret: "s3cret-value",
    subscriptionId: "22222222-2222-2222-2222-222222222222",
  };
  it("finds Azure OpenAI and AI Services accounts and ignores other resources", async () => {
    const f: Fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/oauth2/v2.0/token")) {
        assert.match(String(init?.body), /management\.azure\.com/);
        return reply({ access_token: "t" });
      }
      assert.match(
        url,
        /subscriptions\/2222.*Microsoft\.CognitiveServices\/accounts/,
      );
      return reply({
        value: [
          { name: "oai-prod", kind: "OpenAI", location: "swedencentral" },
          { name: "vision", kind: "ComputerVision", location: "x" },
          { name: "svc", kind: "AIServices", location: "eastus" },
        ],
      });
    };
    const r = await pullAzure(creds, EP, f);
    assert.deepEqual(
      r.signals.map((s) => s.detail),
      ["oai-prod (OpenAI, swedencentral)", "svc (AIServices, eastus)"],
    );
    assert.ok(r.signals.every((s) => s.target === "Azure OpenAI"));
  });
  it("refuses a bad subscription id", async () => {
    await assert.rejects(
      pullAzure({ ...creds, subscriptionId: "nope" }, EP, async () =>
        reply({}),
      ),
      /GUID/,
    );
  });
});

describe("aws connector", () => {
  const creds = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    regions: "us-east-1, eu-west-1",
  };
  it("signs every call and lists Bedrock and SageMaker resources in each region", async () => {
    const seen: string[] = [];
    const f: Fetch = async (input, init) => {
      const url = new URL(String(input));
      const h = init?.headers as Record<string, string>;
      assert.match(
        h.authorization,
        /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/(us-east-1|eu-west-1)\/(bedrock|sagemaker)\/aws4_request/,
      );
      assert.ok(!JSON.stringify(h).includes(creds.secretAccessKey));
      seen.push(url.pathname);
      if (url.pathname === "/bedrock/custom-models")
        return reply({ modelSummaries: [{ modelName: "support-tuned" }] });
      if (url.pathname === "/bedrock/provisioned-model-throughputs")
        return reply({ provisionedModelSummaries: [] });
      return reply({ Endpoints: [{ EndpointName: "fraud-model" }] });
    };
    const r = await pullAws(
      creds,
      { ...EP, awsOverride: "https://aws.test" },
      f,
    );
    assert.equal(seen.length, 6);
    assert.deepEqual(r.signals.map((s) => `${s.target}: ${s.detail}`).sort(), [
      "Amazon Bedrock: custom model support-tuned (eu-west-1)",
      "Amazon Bedrock: custom model support-tuned (us-east-1)",
      "Amazon SageMaker: endpoint fraud-model (eu-west-1)",
      "Amazon SageMaker: endpoint fraud-model (us-east-1)",
    ]);
  });
  it("tolerates a service being off in a region, but fails when nothing works", async () => {
    const half: Fetch = async (input) =>
      new URL(String(input)).pathname.startsWith("/bedrock")
        ? reply({ message: "denied" }, 403)
        : reply({ Endpoints: [] });
    assert.deepEqual(
      (
        await pullAws(
          { ...creds, regions: "us-east-1" },
          { ...EP, awsOverride: "https://aws.test" },
          half,
        )
      ).signals,
      [],
    );
    const none: Fetch = async () =>
      reply(
        { message: "The security token included in the request is invalid." },
        403,
      );
    await assert.rejects(
      pullAws(creds, { ...EP, awsOverride: "https://aws.test" }, none),
      (e: Error) =>
        /security token/.test(e.message) &&
        !e.message.includes(creds.secretAccessKey),
    );
  });
  it("rejects bad regions and keys before any call", async () => {
    await assert.rejects(
      pullAws({ ...creds, regions: "somewhere" }, EP, async () => reply({})),
      /regions/,
    );
    await assert.rejects(
      pullAws({ ...creds, accessKeyId: "x" }, EP, async () => reply({})),
      /access key/,
    );
  });
});
