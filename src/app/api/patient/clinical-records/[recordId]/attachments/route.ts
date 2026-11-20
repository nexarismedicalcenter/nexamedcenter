import { DELETE as remove, GET as read, OPTIONS as options, POST as write } from "@/app/api/appointments/[appointmentId]/clinical-record/attachments/route";

type Context = { params: Promise<{ recordId: string }> };
function adapt(context: Context) {
  return { params: context.params.then(({ recordId }) => ({ appointmentId: recordId })) };
}

export function OPTIONS(request: Request) { return options(request); }
export function GET(request: Request, context: Context) { return read(request, adapt(context)); }
export function POST(request: Request, context: Context) { return write(request, adapt(context)); }
export function DELETE(request: Request, context: Context) { return remove(request, adapt(context)); }
