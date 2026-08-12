<?php

namespace App;

class Dynamic
{
    public function wild($unknown): void
    {
        $unknown->foo();
    }
}
