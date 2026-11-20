import { GET as read, OPTIONS as options } from "@/app/api/appointments/[appointmentId]/clinical-record/pdf/route";

type Context = { params: Promise<{ recordId: string }> };
function adapt(context: Context) {
  return { params: context.params.then(({ recordId }) => ({ appointmentId: recordId })) };
}

export function OPTIONS(request: Request) { return options(request); }
export function GET(request: Request, context: Context) { return read(request, adapt(context)); }
