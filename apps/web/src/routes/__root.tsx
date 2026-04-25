import { Outlet, createRootRouteWithContext } from "@tanstack/solid-router";
// import { TanStackRouterDevtools } from "@tanstack/solid-router-devtools";

export interface RouterContext {}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
});

function RootComponent() {
  return (
    <>
      <div class="grid h-svh min-h-0 overflow-hidden">
        <Outlet />
      </div>
      {/*<TanStackRouterDevtools />*/}
    </>
  );
}
