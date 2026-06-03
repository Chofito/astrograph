import type { AstrographCore, GraphInput, StatusInput } from '@astrograph/core';

export async function handleGraph(facade: AstrographCore, url: URL): Promise<Response> {
  const input: GraphInput = {};
  const limitParam = url.searchParams.get('limit');
  if (limitParam !== null) {
    const limit = Number(limitParam);
    if (Number.isFinite(limit) && limit > 0) {
      input.limit = limit;
    }
  }

  const includeExternalParam = url.searchParams.get('includeExternal');
  if (includeExternalParam !== null) {
    input.includeExternal = includeExternalParam === 'true' || includeExternalParam === '1';
  }

  const kindsParam = url.searchParams.get('kinds');
  if (kindsParam !== null && kindsParam !== '') {
    input.kinds = kindsParam.split(',').map((k) => k.trim()).filter((k) => k !== '') as GraphInput['kinds'];
  }

  const result = await facade.getGraph(input);
  return Response.json(result);
}

export async function handleStatus(facade: AstrographCore): Promise<Response> {
  const result = await facade.getStats({} as StatusInput);
  return Response.json(result);
}
